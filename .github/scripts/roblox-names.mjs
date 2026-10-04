// Roblox user lookup is heavily rate-limited per IP, so batches go through two endpoints
// (Roblox and the roproxy mirror) and every 429 is waited out and retried until the deadline.
const NAME_ENDPOINTS = ['https://users.roblox.com/v1/users', 'https://users.roproxy.com/v1/users'];

export async function resolveUsernames(userIds, deadlineMs = 60_000) {
    const map = {};
    const deadline = Date.now() + deadlineMs;
    const queue = [];
    for (let i = 0; i < userIds.length; i += 100) queue.push(userIds.slice(i, i + 100));
    const total = queue.length;
    let done = 0, rateLimited = 0, unresolvable = 0;

    async function worker(endpoint) {
        let failures = 0;
        while (queue.length && Date.now() < deadline) {
            const batch = queue.shift();
            let ok = false, limited = false;
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const json = await res.json();
                    for (const u of (json.data || [])) map[u.id] = u.displayName || u.name;
                    // IDs Roblox returns nothing for (deleted accounts) are cached as-is so they aren't retried forever.
                    for (const uid of batch) if (!map[uid]) { map[uid] = String(uid); unresolvable++; }
                    done++;
                    failures = 0;
                    ok = true;
                } else if (res.status === 429) {
                    rateLimited++;
                    limited = true;
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.min(Math.max(retryAfter * 1000, 4000), 30000)));
                }
            } catch (_) {}
            if (!ok) {
                queue.unshift(batch);
                if (limited) continue; // already waited; rate limits are expected, not a failure
                failures++;
                if (failures >= 8) return; // endpoint looks down; leave the rest to the other worker
                await new Promise(r => setTimeout(r, Math.min(500 * failures, 4000)));
            }
        }
    }

    await Promise.all(NAME_ENDPOINTS.flatMap(ep => [worker(ep), worker(ep)]));
    console.log(`resolveUsernames: ${done}/${total} batches done, ${queue.length} left for later runs, ${rateLimited} rate-limit waits, ${unresolvable} IDs without a Roblox account.`);
    return map;
}
