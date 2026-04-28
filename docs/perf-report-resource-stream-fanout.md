# Backend bug — `device_resource_stream` fans out to ~7 devices instead of all product devices

## TL;DR

A WebSocket subscription to `device_resource_stream` filtered by `product` should poll every connected device of the product on every interval, but only ~7-8 devices ever produce frames, regardless of how many are connected. The capacity exists — calling the same resource via REST `callDeviceResource` succeeds on **92 of 99** devices in the same fleet — so the bug is specifically in the WS subscription dispatch, not in the device or the script.

This breaks the dashboard's product-metrics panel: aggregated metrics (`sum`, `avg`, `count` over the fleet) report values from a tiny subset of the fleet instead of the whole fleet.

---

## Reproduction

User: `monitoring`. Product: `thinremote`. Resource: `server_stats` (a product-level shell script that calls `curl -fsS http://127.0.0.1/v1/server/statistics`).

### Step 1: confirm fleet shape

```js
const all = await getDevices({ product: 'thinremote' });
const active = filterActiveDevices(all);
// → 99 / 99 connected
```

### Step 2: REST baseline — server-side polling works on most devices

```js
await runPool(active, 10, d => callDeviceResource(d.device, 'server_stats'));
// → ok: 92 / fail: 7 (in 5.5 s wallclock, concurrency 10)
// → sum of all `connections.devices`: 10,378
```

The 7 failures are devices whose internal `thinger` server can't get its license:

```
ERR| cannot get instance configuration for host: braude25.aws.thinger.io
   ({"message":"License is not enabled"})
```

The other 92 return valid JSON with the per-server stats.

### Step 3: WS subscription — only 7-8 frames per cycle, always the same devices

Minimal reproduction (no other subscriptions on the same connection):

```js
const ws = new WebSocket(`wss://${server}/v2/users/${user}/events?authorization=${token}`);
ws.on('open', () => {
    ws.send(JSON.stringify({
        event: 'device_resource_stream',
        filters: { product: 'thinremote', resource: 'server_stats' },
        params: { interval: 60000 },
    }));
});
ws.on('message', raw => {
    const f = JSON.parse(raw);
    if (f.event === 'device_resource_stream') console.log(f.signal, f.device);
});
```

Two observed cycles, ~130 s window:

```
t=0     1 ok + 6 error   = 7 unique devices
t=5s    1 error          = 1 (late retry)
t=20s   6 error          = 6 (sub-cycle, all errors)
t=26s   1 error          = 1 (late retry)
t=60s   1 ok + 6 error   = 7 unique devices  (2nd interval)
t=65s   1 error          = 1 (late retry)
t=120s  1 ok + 6 error   = 7 unique devices  (3rd interval)
```

Exact same set of devices every cycle: `mail`, `perf`, `braude25`, `waytek`, `suilock`, `terrasense`, `water`, `voinalovych`, `ap_06174f7f0ff0`. The other 91 are never polled.

Adding `bucket_write` to the same connection does not change the resource-stream pattern (also 7 per cycle), so the issue is not WS-level rate limiting either.

---

## Code path

When the WS subscription is received the change listener in
`backend/src/thinger/devices/stream_manager.cpp:122` fans out:

```cpp
events::pool.set_event_change_listener("device_resource_stream",
    [this](const std::string& username, events::action action,
           const nlohmann::json& description){
    ...
    } else {
        const std::string& product = get_value(description, "filters.product", empty::string);
        if(!product.empty()) {
            const auto devices = pool.get_devices(username, product);
            for(const auto& device_connection : devices){
                control_stream(device_connection, resource);   // ← per-device
            }
        }
    }
});
```

`pool.get_devices(username, product)` (`device_pool.cpp:120`) is unbounded — it
returns every currently-connected device that matches `(username, product)`. So
for our case the loop iterates 99 times.

`control_stream` (line 190) classifies the device with `get_target` and
delegates to either `control_device_stream` or `control_product_stream` — or
returns silently for `t_none`.

```cpp
stream_manager::stream_target stream_manager::get_target(const std::shared_ptr<device>& dev, const std::string& resource) {
    if(!dev) return t_none;
    const std::string& product  = dev->get_product();
    switch(dev->get_type()){
        case iotmp_device:
        case proto_device:
            if(product.empty() || products.get_resource_type(dev->get_username(), product, resource)==0){
                return t_device;
            }
            return t_product;
        case http_device:
        case mqtt_device:
        case virtual_device:
        case subdevice:
            if(!product.empty()) return t_product;
            break;
    }
    return t_none;
}
```

`control_product_stream` creates a `product_stream` per device and calls its
`start()`. `product_stream::start()`
(`backend/src/thinger/products/product_stream.cpp:207`) has two **silent**
early returns:

```cpp
void product_stream::start() {
    auto profile = profile_.lock();
    if (!profile) {
        LOG_F(WARNING, "product stream profile expired on start...");
        return;                                             // ← silent (just a warning)
    }

    auto api_config = profile->get_api_resource_config(resource_);
    if(!api_config) return;                                 // ← totally silent
    ...
}
```

If 91 devices fail at one of these points the symptom we observe is exactly
this: only a handful of streams ever start, the rest never call `run_resource`,
and no frames are produced for them.

---

## Hypotheses to investigate, in order of likelihood

1. **`get_target` returns `t_none` for the 91 absent devices.** Most likely
   cause: those devices are typed as something not in the switch (an unknown
   enum case), or `dev` is null on the captured pointer. Worth instrumenting:

   ```cpp
   for(const auto& device_connection : devices){
       const auto target = get_target(device_connection, resource);
       LOG_F(2, "device_resource_stream fanout: device=%s type=%d target=%d",
             device_connection ? device_connection->get_device().c_str() : "(null)",
             device_connection ? (int)device_connection->get_type() : -1,
             (int)target);
       control_stream(device_connection, resource);
   }
   ```

2. **`product_stream::start()` silently returns** because either
   `profile_.lock()` fails (the weak ref has expired) or
   `get_api_resource_config(resource_)` returns empty. Add a `LOG_F(WARNING,
   ...)` to the `if(!api_config) return` branch — that's a totally silent path
   today.

3. **`get_resource_type` mis-classifies** the resource for the 91 devices,
   sending them down the `t_device` path (`control_device_stream`) which uses
   the IOTMP stream-control flow rather than the periodic-poll
   `product_stream`. The 7-8 we see succeeding may all be of one type, the
   missing 91 of another. Worth confirming by checking
   `dev->get_type()` distribution: if the polled set is one type and the
   missing set is another, that's the smoking gun.

4. **A race on subscription registration**. The subscription change listener
   at `stream_manager.cpp:122` fires on `events::pool.register_event_listener`.
   If the iteration of `pool.get_devices` happens before all devices are
   registered to the pool, the late ones miss out. They should be picked up by
   `handle_device_connection` later, but if that path doesn't fire for
   already-connected devices that connected before the subscription arrived,
   they'd never get a stream. This would be consistent with "the same 7-8
   devices always" — they happen to be the ones that were first/recent enough
   to be in the pool when the subscription landed.

---

## Update — script timing affects the polled set (partial cause confirmed)

Tightening the script's timeout (5s → 2s) and adding a strict 200-only check (so a `mail.*` server returning a 301 "Moved Permanently" body fails fast instead of returning multi-line non-JSON) **changed** the observed polled set:

```
Original script (curl --max-time 5)        → 7-8 unique devices per cycle, fixed set
Modified script (curl --max-time 2 + 200)  → 10 unique devices per cycle, set rotates
                                              (e.g. `tictul`, `origin`, `perf` appearing
                                              in different cycles)
```

So **part** of the bug is a per-cycle time budget on the server side: slow per-device responses crowd out other devices in the same cycle. A `mail.aws.thinger.io` returning a 301 with a full HTML body via the previous (lenient) script ate enough wallclock to keep ~2 devices out of every cycle.

But the change is small (7→10), nowhere near the 99 expected. So there's a **second** server-side constraint on top of the time budget — probably one of: a hard cap on responses per cycle, a limit on concurrent in-flight resource calls per subscription, or a state-machine bug where the dispatch stops after N successful frames per cycle. Both need to be fixed for the WS to deliver fanout proportional to fleet size.

## What we ruled out

- **Not the script.** Direct REST resource_call works on 92/99. The 7 that
  fail via REST are the same 7 always failing via WS (license issue), so the
  script behaviour is consistent across paths.
- **Not the WS connection.** Isolated subscription with no other events
  reproduces the same 7-frame-per-cycle pattern.
- **Not WS-level rate limiting.** Adding the high-frequency `bucket_write`
  subscription on the same WS does not degrade `device_resource_stream`
  delivery further.
- **Not the dashboard client.** Its handler simply consumes whatever the
  server sends — and we instrumented every dropped frame, none are dropped at
  the client beyond the legitimate `signal: error` ones.

---

## Empirical raw data

```
99 active devices in product `thinremote`
REST call (callDeviceResource) → 92 ok / 7 fail in 5.5 s, sum of devices = 10,378

WS device_resource_stream isolated:
  cycle  t=0     7 unique (1 data + 6 error)
  late   t=5s    1 unique (error)
  cycle  t=20s   6 unique (all error, sub-cycle)
  late   t=26s   1 unique (error)
  cycle  t=60s   7 unique (1 data + 6 error)
  late   t=65s   1 unique (error)
  cycle  t=120s  7 unique (1 data + 6 error)

WS device_resource_stream + bucket_write same connection:
  same 7-per-cycle pattern, bucket_write delivered ~212 frames over 2 min independently

Polled set across multiple test runs (consistent):
  mail_062d0031f101            (data)
  perf_06470f34b3b2            (data)
  braude25_0a590bc32ed5        (error: 500 / License is not enabled)
  waytek_06b62a508635          (error: 500)
  suilock_06f02f182719         (error: 500)
  terrasense_0e9f970d8bc0      (error: 500)
  water_06090cb68a1b           (error: 500)
  voinalovych_028abe7b9a7b     (error: 500)
  ap_06174f7f0ff0              (error: 500, late)

Missing from any cycle: 91 other devices (e.g. `tslab`, `tictul`, `treezoom`,
`eu`, `ecobreeze`, `datalink`, `us`, `mso`, `ap_02e0597462f4`, `thinger`,
`swinp`, `monitoring`, `insitueng`, ... etc.) all of which return valid stats
when called via REST.

Tested 2026-04-27 against thinger.thinr.io.
```
