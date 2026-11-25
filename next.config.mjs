import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'pdfkit', 'unpdf', 'jszip'],
  poweredByHeader: false,
  webpack: (config) => { config.resolve.alias['@'] = path.join(root, 'src'); return config; },
};
