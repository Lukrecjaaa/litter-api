
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const redis = require('redis');
const base58check = require('base58check');
const cron = require('cron').CronJob;
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const base_path = process.env.BASE_PATH || './uploads';
let upload = multer({ dest: base_path });

app.use(cors({
  origin: process.env.CORS_ALLOWED_ORIGIN,
  optionsSuccessStatus: 200
}));

const uploadLimiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW || 60 * 60 * 1000,
  max: process.env.MAX_FILE_AMOUNT || 100,
  standardHeaders: true,
  legacyHeaders: false
});

let redisClient;

let job = new cron(
  '* * * * *',
  function() {
    fs.readdirSync(base_path).forEach(async (file) => {
      try {
        let current_date = new Date().getTime();
  
        let filename_encoded = await redisClient.get(file);
        let file_data = await redisClient.get(filename_encoded);
        file_data = JSON.parse(file_data);
        let expired = file_data.expiry_date < current_date;

        if (expired) {
          fs.rmSync(path.join(base_path, file));
          await redisClient.del(filename_encoded);
          await redisClient.del(file);
        }
      } catch {
        try {
          const stats = fs.statSync(path.join(base_path, file));

          const one_hour = 60 * 60 * 1000;
          const current_date = new Date().getTime();
          const file_time = stats.mtime.getTime();

          if (current_date - file_time > one_hour) {
            fs.rmSync(path.join(base_path, file));
          }
        } catch {}
      }
    });
  },
  null,
  false
);

(async () => {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL
  });

  redisClient.on("error", (error) => {
    console.error(error);
  });

  await redisClient.connect();

  job.start();
})();

async function downloadFile(req, res) {
  const filename_encoded = req.params.name;

  try {
    const result = await redisClient.get(filename_encoded);
    if (result) {
      const object = JSON.parse(result);
      res.set({
        'Content-Disposition': `inline; filename="${object.file.originalname}"`,
        'Content-Type': `${object.file.mimetype}`,
      });
      res.send(fs.readFileSync(object.file.path));
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
    let out = req.file;

    const current_date = new Date();
    let expiry_date = new Date(current_date.getTime() + Number(req.body.expire_after) * 60 * 60 * 1000).getTime();
    
    let filename_encoded = base58check.encode(out.filename).substring(1, 7); // skip first character
    
    await redisClient.set(filename_encoded, JSON.stringify(
      {
        file: out,
        expiry_date: expiry_date,
        token: req.query.token
      }
    ));

    await redisClient.set(out.filename, filename_encoded);
    
    res.json({ path: filename_encoded });
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

async function removeFile(req, res) {
  try {
    const file_data = req.file_data;
    const filename_encoded = req.filename_encoded;
    let path = file_data.file.path;

    fs.rmSync(path);
    await redisClient.del(filename_encoded);
    await redisClient.del(file_data.file.filename);

    res.sendStatus(200);
  } catch (err) {
    res.status(500);
    res.send(err);
  }
}

async function newToken(ip) {
  const token = crypto.randomUUID();
  const current_date = new Date();
  // 5 minutes from now
  const expiry_date = new Date(current_date.getTime() + 5 * 60 * 1000).getTime();
  await redisClient.set(`token:${ip}`, JSON.stringify({
    token: token,
    expiry_date: expiry_date
  }));
  return token;
}

async function generateToken(req, res) {
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    try {
      const prev_token = await redisClient.get(`token:${clientIp}`);
      const parsed = JSON.parse(prev_token);
      const current_date = new Date().getTime();
      const expired = parsed.expiry_date < current_date;

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

async function checkToken(req, res, next) {
  const token = req.query.token;

  if (!token) {
    res.status(403);
    return res.send('Session token required');
  }

  const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const token_data = await redisClient.get(`token:${currentIp}`);
  const parsed = JSON.parse(token_data);
  const current_date = new Date().getTime();
  const expired = parsed.expiry_date < current_date;

  if (expired) {
    res.status(403);
    return res.send('Session token expired');
  } else {
    next();
  }
}

async function isUploadOwner(req, res, next) {
  try {
    const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const token_data = await redisClient.get(`token:${currentIp}`);
    const parsed_token = JSON.parse(token_data);

    const filename_encoded = req.params.name;
    
    let file_data = await redisClient.get(filename_encoded);
    file_data = JSON.parse(file_data);

    if (parsed_token.token == file_data.token) {
      req.file_data = file_data;
      req.filename_encoded = filename_encoded;
      next();
    } else {
      res.status(403);
      return res.send('Not an owner of the file');
    }
  } catch (err) {
    res.status(403);
    return res.send('Cannot check file ownership');
  }
}

app.set('trust proxy', 1);
app.use('/upload', uploadLimiter);

app.post('/upload', checkToken, upload.single('file'), uploadFile);
app.get("/remove/:name", checkToken, isUploadOwner, removeFile);
app.get("/token", generateToken);
app.get("/:name", downloadFile);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
