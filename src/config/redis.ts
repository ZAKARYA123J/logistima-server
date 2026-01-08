import { createClient,RedisClientType } from "redis";
const REDIS_URL="redis://localhost:6379"
const REDIS_PASSWORD:process.env.password || undefined
