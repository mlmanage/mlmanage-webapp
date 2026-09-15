import type { NextConfig } from "next"

const allowedDevOrigins = (process.env.MLM_ALLOWED_DEV_ORIGINS || "localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

const nextConfig: NextConfig = {
  devIndicators: false,
  // Add comma-separated development hosts with MLM_ALLOWED_DEV_ORIGINS when the app
  // needs to be accessed from a machine other than the one running Next.js.
  allowedDevOrigins,
}

export default nextConfig
