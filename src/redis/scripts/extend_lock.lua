-- KEYS[1] = wh:lock:{deliveryId}   ARGV[1] = token   ARGV[2] = ttl_ms
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
