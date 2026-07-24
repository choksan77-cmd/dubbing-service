/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["ffmpeg-static", "yt-dlp-exec"],
  },
};

export default nextConfig;
