/** @type {import('next').NextConfig} */
// Hi-Vis builds into its own folder, so both templates can be built and served side by side.
const hivis = (process.env.NEXT_PUBLIC_CB_TEMPLATE ?? '').trim().toLowerCase() === 'hivis';
// CB_STATIC_EXPORT=1 writes the whole site as plain files to out/, for the cPanel host
// (docs/CPANEL.md). Trailing slashes give every page its own folder with an index.html, which
// Apache serves without rewrite rules.
const staticExport = (process.env.CB_STATIC_EXPORT ?? '').trim() === '1';

const nextConfig = {
  distDir: hivis ? '.next-hivis' : '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  ...(staticExport ? { output: 'export', trailingSlash: true } : {}),
};

export default nextConfig;
