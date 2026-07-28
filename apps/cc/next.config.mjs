/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@mydon/shared", "@mydon/assistant"],
};

export default nextConfig;
