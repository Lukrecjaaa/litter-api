/* eslint-disable consistent-return */
/* eslint-disable no-console */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const redis = require('redis');
const base58check = require('base58check');
const Cron = require('cron').CronJob;
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('node:crypto');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const basePath = process.env.BASE_PATH || './uploads';
const upload = multer({ dest: basePath });

/* Set up CORS and expose Content-Disposition header */
app.use(cors({
  origin: process.env.CORS_ALLOWED_ORIGIN,
  optionsSuccessStatus: 200,
  exposedHeaders: 'Content-Disposition',
}));

/* Set up rate limit (default: 25 uploads per hour) */
const uploadLimiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW || 60 * 60 * 1000,
  max: process.env.MAX_FILE_AMOUNT || 25,
  standardHeaders: true,
  legacyHeaders: false,
});

let redisClient;

/* Run a cron task every minute */
const job = new Cron(
  '* * * * *',
  (() => {
    fs.readdirSync(basePath).forEach(async (file) => {
      try {
        const currentDate = new Date().getTime();

        const filenameEncoded = await redisClient.get(file);
        let fileData = await redisClient.get(filenameEncoded);
        fileData = JSON.parse(fileData);
        const expired = fileData.expiryDate < currentDate;

        /* Remove file if it's expired... */
        if (expired) {
          fs.rmSync(path.join(basePath, file));
          await redisClient.del(filenameEncoded);
          await redisClient.del(file);
        }
      } catch {
        /* ...or if it's not in the database (eg. when upload is interrupted) */
        try {
          const stats = fs.statSync(path.join(basePath, file));

          const oneHour = 60 * 60 * 1000;
          const currentDate = new Date().getTime();
          const fileTime = stats.mtime.getTime();

          if (currentDate - fileTime > oneHour) {
            fs.rmSync(path.join(basePath, file));
          }
        } catch { /* empty */ }
      }
    });
  }),
  null,
  false,
);

/* Connect to Redis database */
(async () => {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL,
  });

  redisClient.on('error', (error) => {
    console.error(error);
  });

  await redisClient.connect();

  job.start();
})();

/* File download endpoint */
async function downloadFile(req, res) {
  const filenameEncoded = req.params.name;

  try {
    const result = await redisClient.get(filenameEncoded);
    if (result) {
      const object = JSON.parse(result);
      const filePath = object.file.path;

      res.set({
        'Content-Disposition': `inline; filename="${object.file.originalname}"`,
        'Content-Type': `${object.file.mimetype}`,
      });
      res.send(fs.readFileSync(filePath));

      /* Remove the file if burn-after-download is turned on */
      if (object.burn) {
        fs.rmSync(filePath);
        await redisClient.del(filenameEncoded);
        await redisClient.del(object.file.filename);
      }
    } else {
      res.status(404);
      res.send('Requested file cannot be found');
    }
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

async function uploadFile(req, res) {
  try {
    const out = req.file;

    const currentDate = new Date();
    const expiryDate = new Date(
      currentDate.getTime() + Number(req.body.expireAfter) * 60 * 60 * 1000,
    ).getTime();
    const burn = (req.body.burn === 'true');

    /* Skip first base58check character */
    const filenameEncoded = base58check.encode(out.filename).substring(1, 7);

    /* Set two redis entries */
    await redisClient.set(filenameEncoded, JSON.stringify(
      {
        file: out,
        expiryDate,
        token: req.query.token,
        burn,
      },
    ));

    await redisClient.set(out.filename, filenameEncoded);

    /* Return encoded filename */
    res.json({ path: filenameEncoded });
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

/* Remove file and its database entry */
async function removeFile(req, res) {
  try {
    const { fileData } = req;
    const { filenameEncoded } = req;
    const filePath = fileData.file.path;

    fs.rmSync(filePath);
    await redisClient.del(filenameEncoded);
    await redisClient.del(fileData.file.filename);

    res.sendStatus(200);
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

/* Generate a random UUID v4 token and save it to database */
async function newToken(ip) {
  const token = randomUUID();
  const currentDate = new Date();
  /* 1 hour from now */
  const expiryDate = new Date(currentDate.getTime() + 60 * 60 * 1000).getTime();
  await redisClient.set(`token:${ip}`, JSON.stringify({
    token,
    expiryDate,
  }));
  return token;
}

/* Send a token to client if it exists, generate it otherwise */
async function generateToken(req, res) {
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    try {
      const prevToken = await redisClient.get(`token:${clientIp}`);
      const parsed = JSON.parse(prevToken);
      const currentDate = new Date().getTime();
      const expired = parsed.expiryDate < currentDate;

      if (expired) {
        res.json({ token: await newToken(clientIp) });
      } else {
        res.json({ token: parsed.token });
      }
    } catch {
      res.json({ token: await newToken(clientIp) });
    }
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

/* Middleware for checking if token exists or if it's valid */
async function checkToken(req, res, next) {
  const { token } = req.query;

  if (!token) {
    res.status(403);
    return res.send('Session token required');
  }

  const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const tokenData = await redisClient.get(`token:${currentIp}`);
  const parsed = JSON.parse(tokenData);
  const currentDate = new Date().getTime();
  const expired = parsed.expiryDate < currentDate;

  if (expired) {
    res.status(403);
    return res.send('Session token expired');
  }

  next();
}

/* Middleware for checking if user is an owner of the upload
  (used to prevent unauthorized people from removing others' files) */
async function isUploadOwner(req, res, next) {
  try {
    const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tokenData = await redisClient.get(`token:${currentIp}`);
    const parsedToken = JSON.parse(tokenData);

    const filenameEncoded = req.params.name;

    let fileData = await redisClient.get(filenameEncoded);
    fileData = JSON.parse(fileData);

    if (parsedToken.token === fileData.token) {
      req.fileData = fileData;
      req.filenameEncoded = filenameEncoded;
      next();
    } else {
      res.status(403);
      return res.send('Not an owner of the file');
    }
  } catch (err) {
    res.status(403);
    return res.send('File doesn\'t exist');
  }
}

/* Needed for rate limiting to work behind a reverse proxy */
app.set('trust proxy', 1);
app.use('/upload', uploadLimiter);

app.post('/upload', checkToken, upload.single('file'), uploadFile);
app.get('/remove/:name', checkToken, isUploadOwner, removeFile);
app.get('/token', generateToken);
app.get('/:name', downloadFile);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
