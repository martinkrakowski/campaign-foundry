import type { NextConfig } from "next";

// The Nitro pipeline API. The browser only ever talks to this Next app; requests
// to /api/pipeline/* are rewritten server-side to Nitro, so there is no CORS.
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

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
