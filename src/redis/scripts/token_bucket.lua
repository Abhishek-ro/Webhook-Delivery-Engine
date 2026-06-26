-- KEYS[1] = wh:rl:{endpointId}   ARGV[1] = max_tokens (50)   ARGV[2] = ttl_s (120)
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
if tokens <= 0 then return -1 end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tokens - 1
