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
