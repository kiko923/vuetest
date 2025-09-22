export function onRequestGet(context) {
  return new Response('hello world', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}


