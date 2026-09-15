export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(
    {
      error: "WebSocket upgrade bridge is not installed in this Next.js runtime.",
      detail:
        "Browser clients must use this same-origin /api/mlmanage-ws path for task exec. Deploy a custom Node/reverse-proxy upgrade bridge here to connect server-side to the MLManage backend WebSocket; do not connect browsers directly to the backend host.",
    },
    { status: 426, headers: { "cache-control": "no-store" } },
  )
}
