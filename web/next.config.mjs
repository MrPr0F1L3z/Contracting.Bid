/** @type {import('next').NextConfig} */
// Hi-Vis builds into its own folder, so both templates can be built and served side by side.
const hivis = (process.env.NEXT_PUBLIC_CB_TEMPLATE ?? '').trim().toLowerCase() === 'hivis';

const nextConfig = {
  distDir: hivis ? '.next-hivis' : '.next',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
