/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["ffmpeg-static", "yt-dlp-exec"],
    instrumentationHook: true,
  },
};

export default nextConfig;
