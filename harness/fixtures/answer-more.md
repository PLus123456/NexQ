
### If they ask about failure modes

- **Redis is down**: fail open for reads and fail closed for payments; say which and why.
- **Clock skew**: let Redis keep the time (`TIME`), never the callers.
- **Hot tenants**: one key per tenant and route; a single key for everything becomes the bottleneck.

### Numbers worth having ready

With \( B = 200 \) and \( r = 50 \) per second, a client that was idle can send 200 requests at once and then 50 a second. Over a minute that is at most \( 200 + 50 \cdot 60 = 3200 \) requests.

Some models write dollars instead: the average rate over a window is $\bar r = N / T$, and in one line

$$ \bar r_{60} = \frac{B + 60\,r}{60} = \frac{200 + 3000}{60} \approx 53.3 \text{ requests per second, which is a little above the refill rate} $$

说完以后可以反问一句：他们现在的限流是按用户、按 IP，还是按 API Key？这样能把话题带回对方的系统。

1. State the choice and the reason in one sentence.
2. Walk through one request, from the gateway to the counter and back.
3. Name the two failure modes above before they ask.
4. Close with what you would measure in the first week.

---

A last check before answering out loud: the interviewer asked two things, the design and what you would change. Give the design in thirty seconds, then spend the rest on the second part, because that is where your own experience shows.
