/**
 * Auto-generated Dockerfile templates for common frameworks.
 *
 * When a user pushes a React / Vite / Next.js / etc. repo without a
 * Dockerfile, the platform generates one of these on the fly so the
 * deploy "just works" — no Docker knowledge required.
 *
 * Each template is a complete, production-ready Dockerfile. They all
 * target a fixed internal port (port 80 for nginx SPAs, port 3000 for
 * Node servers) so the user never sees a port question. Caddy reaches
 * the container by `container_name` on the shared `dockcontrol-apps`
 * network — no host port publish needed.
 *
 * Detection priority is determined by detectStack() in
 * applications.service. The first match wins.
 */

export type AutoFramework =
  | 'NEXTJS'
  | 'NUXT'
  | 'SVELTEKIT'
  | 'REMIX'
  | 'ASTRO'
  | 'REACT'      // CRA / Vite-React (SPA build)
  | 'VUE'        // Vite-Vue / Vue-CLI
  | 'VITE'       // generic Vite SPA
  | 'STATIC'     // raw HTML
  | 'NODE'       // package.json with "start" but no framework match
  | 'PYTHON'
  | 'PHP';

/** The internal port the auto-generated image listens on. */
export const FRAMEWORK_INTERNAL_PORT: Record<AutoFramework, number> = {
  NEXTJS: 3000,
  NUXT: 3000,
  SVELTEKIT: 3000,
  REMIX: 3000,
  ASTRO: 4321,
  REACT: 80,
  VUE: 80,
  VITE: 80,
  STATIC: 80,
  NODE: 3000,
  PYTHON: 8000,
  PHP: 80,
};

const NGINX_SPA_CONF = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files \\$uri \\$uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
    gzip_min_length 1024;
}
`;

/**
 * SPA (React/Vite/Vue) — 2-stage build:
 *   1. node:20-alpine installs + builds → /app/dist (Vite) or /app/build (CRA)
 *   2. nginx:alpine serves the build dir + SPA routing fallback.
 *
 * Adapts to common output dirs by trying dist first, then build.
 */
function spaTemplate(buildOutputCandidates: string[]): string {
  const tryCopy = buildOutputCandidates
    .map((d) => `COPY --from=builder /app/${d} /usr/share/nginx/html`)
    .join(' 2>/dev/null || ');
  return `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f pnpm-lock.yaml ]; then \\
      corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then \\
      yarn install --frozen-lockfile; \\
    else \\
      npm install --no-audit --prefer-offline; \\
    fi
COPY . .
RUN npm run build 2>/dev/null || pnpm run build 2>/dev/null || yarn build

FROM nginx:alpine AS runtime
RUN echo '${NGINX_SPA_CONF.replace(/\n/g, '\\n').replace(/'/g, "'\\''")}' > /etc/nginx/conf.d/default.conf
# Copy whichever build dir exists. Vite emits dist/, CRA emits build/.
${tryCopy} || (echo "No build output found in ${buildOutputCandidates.join(' or ')}"; exit 1)
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
}

export const REACT_DOCKERFILE = spaTemplate(['dist', 'build']);
export const VUE_DOCKERFILE = spaTemplate(['dist']);
export const VITE_DOCKERFILE = spaTemplate(['dist']);

/** Next.js — full Node runtime with standalone output. */
export const NEXTJS_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f pnpm-lock.yaml ]; then \\
      corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then \\
      yarn install --frozen-lockfile; \\
    else \\
      npm install --no-audit --prefer-offline; \\
    fi

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build 2>/dev/null || pnpm run build 2>/dev/null || yarn build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
`;

/** Nuxt 3 — similar shape to Next. */
export const NUXT_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f pnpm-lock.yaml ]; then \\
      corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then \\
      yarn install --frozen-lockfile; \\
    else \\
      npm install --no-audit --prefer-offline; \\
    fi
COPY . .
RUN npm run build 2>/dev/null || pnpm run build 2>/dev/null || yarn build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
`;

/** SvelteKit. */
export const SVELTEKIT_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --prefer-offline
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "build"]
`;

/** Remix. */
export const REMIX_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --prefer-offline
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "start"]
`;

/** Astro — supports both static (SSG) and SSR. We assume static here. */
export const ASTRO_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --prefer-offline
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime
RUN echo '${NGINX_SPA_CONF.replace(/\n/g, '\\n').replace(/'/g, "'\\''")}' > /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;

/** Pure-static / single index.html — just serve the repo root with nginx. */
export const STATIC_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM nginx:alpine
RUN echo '${NGINX_SPA_CONF.replace(/\n/g, '\\n').replace(/'/g, "'\\''")}' > /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;

/** Generic Node (server app with start script, no recognised framework). */
export const NODE_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN if [ -f pnpm-lock.yaml ]; then \\
      corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then \\
      yarn install --frozen-lockfile; \\
    else \\
      npm install --no-audit --prefer-offline; \\
    fi
COPY . .
RUN npm run build 2>/dev/null || true
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "npm start"]
`;

/** Python (auto-detect Flask/FastAPI). */
export const PYTHON_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; \\
    elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi
COPY . .
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "if [ -f main.py ]; then python main.py; elif [ -f app.py ]; then python app.py; else python -m http.server 8000; fi"]
`;

/** PHP-served via Apache. */
export const PHP_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM php:8.4-apache
COPY . /var/www/html/
EXPOSE 80
`;

export const FRAMEWORK_DOCKERFILES: Record<AutoFramework, string> = {
  NEXTJS: NEXTJS_DOCKERFILE,
  NUXT: NUXT_DOCKERFILE,
  SVELTEKIT: SVELTEKIT_DOCKERFILE,
  REMIX: REMIX_DOCKERFILE,
  ASTRO: ASTRO_DOCKERFILE,
  REACT: REACT_DOCKERFILE,
  VUE: VUE_DOCKERFILE,
  VITE: VITE_DOCKERFILE,
  STATIC: STATIC_DOCKERFILE,
  NODE: NODE_DOCKERFILE,
  PYTHON: PYTHON_DOCKERFILE,
  PHP: PHP_DOCKERFILE,
};

/**
 * Detect the most appropriate framework from a freshly-cloned repo's
 * filesystem. Reads package.json + lockfiles + a few sentinel files.
 * Returns null when nothing matches — caller falls back to STATIC.
 */
export function detectStack(repoDir: string): AutoFramework | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');

  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(repoDir, rel));
    } catch {
      return false;
    }
  };

  // Sentinels — when one exists the user has already brought their own
  // image plan; we honour it instead of generating.
  if (has('Dockerfile')) return null;
  if (has('docker-compose.yml') || has('compose.yml')) return null;

  // Python
  if (has('requirements.txt') || has('pyproject.toml')) return 'PYTHON';

  // PHP
  if (has('composer.json') || has('index.php')) return 'PHP';

  // Node — read package.json to disambiguate.
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'),
      );
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const scripts = pkg.scripts || {};

      if (deps.next) return 'NEXTJS';
      if (deps.nuxt || deps['nuxt3']) return 'NUXT';
      if (deps['@sveltejs/kit']) return 'SVELTEKIT';
      if (deps['@remix-run/serve'] || deps['@remix-run/node']) return 'REMIX';
      if (deps.astro) return 'ASTRO';

      // Vite-React / CRA / Vue / generic Vite
      if (deps.react || deps['react-dom']) {
        if (deps.vite) return 'REACT';
        if (deps['react-scripts']) return 'REACT';
        return 'REACT';
      }
      if (deps.vue || deps['@vue/cli-service']) return 'VUE';
      if (deps.vite) return 'VITE';

      // Node server — has start script + no known SPA framework.
      if (scripts.start) return 'NODE';
    } catch {
      // package.json unparseable → fall through to static.
    }
  }

  // No framework, but a static index.html in the root → serve as static.
  if (has('index.html')) return 'STATIC';

  return null;
}
