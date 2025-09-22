const express = require('express');
const cors = require('cors');
const tencentcloud = require('tencentcloud-sdk-nodejs-teo');

const TeoClient = tencentcloud.teo.v20220901.Client;

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.get('/api/test', (req, res) => {
  res.type('text/plain; charset=utf-8').send('hello world');
});

// /api/num - Tencent EdgeOne metrics proxy
function toIso8601WithoutMilliseconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

app.all('/api/num', async (req, res) => {
  // CORS headers (in addition to global cors middleware)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const clientConfig = {
    credential: {
      secretId: process.env.TENCENTCLOUD_SECRET_ID,
      secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
    },
    region: "",
    profile: {
      httpProfile: {
        endpoint: "teo.tencentcloudapi.com",
      },
    },
  };

  const client = new TeoClient(clientConfig);

  const { act } = req.query || {};
  const metricMap = {
    request: "l7Flow_request_url",
    flow: "l7Flow_outFlux_url",
  };
  const metricName = metricMap[act] || "l7Flow_request_url";

  const endDate = new Date();
  const endTime = toIso8601WithoutMilliseconds(endDate);
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startTime = toIso8601WithoutMilliseconds(startDate);

  const params = {
    StartTime: startTime,
    EndTime: endTime,
    MetricName: metricName,
    Limit: 101,
    Filters: [
      { Key: "domain", Operator: "equals", Value: ["cdnjs.znnu.com"] },
      { Key: "statusCode", Operator: "equals", Value: ["200"] },
      { Key: "url", Operator: "notInclude", Value: ["/pages"] },
    ],
  };

  try {
    const data = await client.DescribeTopL7AnalysisData(params);

    if (data?.Data && Array.isArray(data.Data)) {
      data.Data = data.Data.map((item) => {
        if (Object.prototype.hasOwnProperty.call(item, 'TypeKey')) {
          delete item.TypeKey;
        }
        if (Array.isArray(item.DetailData)) {
          item.DetailData = item.DetailData.filter((d) => d.Key !== "/");
        }
        return item;
      });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("API 调用失败:", err);
    res.status(500).json({ error: "API 调用失败", detail: err?.message || err });
  }
});

// Not found handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


