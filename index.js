
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const redis = require('redis');
const base58check = require('base58check');
const cron = require('cron').CronJob;
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const base_path = process.env.BASE_PATH || './uploads';
let upload = multer({ dest: base_path });

app.use(cors({
  origin: process.env.CORS_ALLOWED_ORIGIN,
  optionsSuccessStatus: 200
}));

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
        fs.rmSync(path.join(base_path, file));
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
      res.download(object.path, object.originalname);
    } else {
      res.status(404);
      res.json({ error: 'Requested file cannot be found' });
    }
  } catch (err) {
    res.status(500);
    res.json({ error: err });
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
        originalname: out.originalname,
        path: out.path,
        expiry_date: expiry_date,
        filename: out.filename
      }
    ));

    await redisClient.set(out.filename, filename_encoded);
    
    res.json({ path: filename_encoded });
  } catch (err) {
    res.status(500);
    res.json({ error: err });
  }
}

async function removeFile(req, res) {
  try {
    const filename_encoded = req.params.name;

    let file_data = await redisClient.get(filename_encoded);
    file_data = JSON.parse(file_data);
    let path = file_data.path;

    fs.rmSync(path);
    await redisClient.del(filename_encoded);
    await redisClient.del(file_data.filename);

    res.json({ message: 'OK' });
  } catch (err) {
    res.status(500);
    res.json({ error: err });
  }
}

app.post('/', upload.single('file'), uploadFile);
app.get("/:name", downloadFile);
app.get("/remove/:name", removeFile);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
