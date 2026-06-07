import type { NextConfig } from "next";

// The Nitro pipeline API. The browser only ever talks to this Next app; requests
// to /api/pipeline/* are rewritten server-side to Nitro, so there is no CORS.
// Use 127.0.0.1 (not "localhost"): Node resolves "localhost" to IPv4 while Nitro's
// dev server may bind IPv6-only (::1), which makes the rewrite fail with a 500.
const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@campaignfoundry/CampaignOrchestration",
    "@campaignfoundry/CreativeGeneration",
    "@campaignfoundry/GovernanceAndCompliance",
    "@campaignfoundry/Distribution",
    "@campaignfoundry/shared",
  ],
  async rewrites() {
    return [{ source: "/api/pipeline/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
