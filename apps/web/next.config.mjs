/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@agentready/domain",
    "@agentready/catalog",
    "@agentready/audit",
    "@agentready/payments",
    "@agentready/conformance",
  ],
};

export default nextConfig;