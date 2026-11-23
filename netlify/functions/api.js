import serverless from 'serverless-http';
import app from '../../server.js';

const serverlessHandler = serverless(app, {
  request(req) {
    if (req.url && req.url.startsWith('/.netlify/functions/api')) {
      const stripped = req.url.slice('/.netlify/functions/api'.length);
      req.url = '/api' + (stripped.startsWith('/') ? stripped : '/' + stripped);
    }
  },
});

export const handler = async (event, context) => {
  return serverlessHandler(event, context);
};
