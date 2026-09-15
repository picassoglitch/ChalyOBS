/**
 * GET /oauth/done?connected=… | ?connect_error=…
 *
 * Terminal page of the OAuth popup flow. The Conectar button opens
 * /api/oauth/[platform]/start in a POPUP (Restream-style); the callback
 * 303s here, and this page hands the result back to the dashboard that
 * opened it (postMessage) and closes itself.
 *
 * Fallback: when there is no opener (popup blocked → full-page navigation,
 * or the platform's COOP severed the reference), it becomes a plain
 * redirect to /dashboard carrying the same query params, which the server
 * page already knows how to render as a banner.
 */

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ChalyOBS</title></head>
<body style="background:#0a0a0a;color:#888;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Conexión completada — puedes cerrar esta ventana.</p>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var payload = {
    source: "chalybobs-oauth",
    connected: params.get("connected"),
    connectError: params.get("connect_error"),
  };
  if (window.opener) {
    try { window.opener.postMessage(payload, location.origin); } catch (e) {}
    window.close();
  } else {
    location.replace("/dashboard?" + params.toString());
  }
})();
</script>
</body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
