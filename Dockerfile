FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
# web/ is not needed for the API/bot; server serves GET / and SSE only.
# Keep image small — no secrets are copied (.env is gitignored and dockerignored).
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
