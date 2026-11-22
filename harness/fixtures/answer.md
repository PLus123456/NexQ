## Rate limiter: what I would build

Start from the **token bucket**: it allows short bursts and is cheap to store. 每个租户一个桶，容量 \( B \)，按速率 \( r \) 补充令牌。

### How it decides

1. Read the bucket for the tenant from Redis.
2. Refill it for the time that has passed:
   - elapsed time \( \Delta t = t_{now} - t_{last} \)
   - new level \( \min(B,\; n + r \cdot \Delta t) \)
     - never above the capacity
     - never below zero
3. Take one token, or reject with `429 Too Many Requests`.

The longest burst a client can send in a window of length \( T \) is

\[
N_{max} = B + r \cdot T
\]

and the share of rejected requests at a steady arrival rate \( \lambda > r \) settles at

\[
P_{reject} = 1 - \frac{r}{\lambda}
\]

### Options compared

| Algorithm | Memory per key | Bursts | Good for |
| --- | --- | --- | --- |
| Fixed window | 1 counter | double at the edge | simple quotas |
| Sliding log | 1 entry per request | exact | low traffic, audits |
| Token bucket | 2 numbers | up to `B` | APIs with bursts |
| Leaky bucket | queue length | none | smoothing writes |

### Sketch

```ts
function allow(bucket: Bucket, now: number): boolean {
  const refill = (now - bucket.updatedAt) * bucket.ratePerMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
```

> 说的时候先给结论：令牌桶，按租户限流，Redis 里用一段 Lua 保证原子性。

What I would do differently today:

- keep the limits in **config**, not in code, so support can raise one tenant without a deploy;
- return `Retry-After` with the seconds until the next token, \( (1 - n) / r \);
- watch the reject rate per tenant: a plan that costs $5 or $10 a month should rarely hit it.

More background: [token bucket](https://example.com/token-bucket).
