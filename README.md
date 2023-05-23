# litter-api

## Configuring and running project
### Installing dependencies
```
yarn
```

### Runnning
#### Normal
```
node index.js
```
#### Nodemon
```
mkdir uploads
yarn nodemon -V --ignore uploads
```

## Running Redis instance in docker
```
docker run -p 6379:6379 --name redis -d redis redis-server --save 60 1 --loglevel warning
```

## Environment variables
- `PORT` - which port to use (defaults to `3000`)
- `BASE_PATH` - path to a directory where files should be saved (defaults to `'./uploads'`)
- `MAX_SIZE` - maximum allowed file size in bytes, should have the same value as maximum file size allowed by the frontend (defaults to `104857600` - 100 MiB)
- `CORS_ALLOWED_ORIGIN` - URL of frontend
- `RATE_LIMIT_WINDOW` - time window in which user requests are remembered (defaults to `60 * 60 * 1000` - 1 hour)
- `MAX_FILE_AMOUNT` - maximum number of files uploaded per user in the specified time window (defaults to `25`)
- `REDIS_URL` - URL of running Redis database instance