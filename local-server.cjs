const http = require('node:http');

const host = '127.0.0.1';
const port = Number(process.argv[2] ?? 8000);

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Локальный сервер работает.\n');
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Страница не найдена.\n');
});

server.listen(port, host, () => {
  console.log(`http://${host}:${port}`);
});
