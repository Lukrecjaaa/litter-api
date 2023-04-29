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
yarn nodemon -V --ignore uploads/*
```

## Running Redis instance in docker
```
docker run --name redis -d redis redis-server --save 60 1 --loglevel warning
```
