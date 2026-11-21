FROM node:22-slim
WORKDIR /app
RUN corepack enable
# This image runs the simulation only. The site in web/ is a separate workspace package,
# so install just the root package; web/package.json is copied because the lockfile names it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter contracting-bid
COPY . .
RUN pnpm build
CMD ["pnpm", "test"]
