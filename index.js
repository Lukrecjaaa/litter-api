
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const redis = require('redis');
const base58check = require('base58check');

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

(async () => {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL
  });

  redisClient.on("error", (error) => {
    console.error(error);
  });

  await redisClient.connect();
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
    var out = req.file;
    let filename_encoded = base58check.encode(out.filename).substring(1, 7); // skip first character
    await redisClient.set(filename_encoded, JSON.stringify(
      {
        originalname: out.originalname,
        path: out.path
      }
    ));
    res.json({ path: filename_encoded });
  } catch (err) {
    res.status(500);
    res.json({ error: err });
  }
}

app.post('/', upload.single('file'), uploadFile);
app.get("/:name", downloadFile);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
