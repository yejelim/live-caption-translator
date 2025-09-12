# ---------- deps ----------
FROM node:20-bullseye-slim AS deps
WORKDIR /app
# 패키지 매니저 하나만 고집(권장: npm). yarn/pnpm 잠깐 쓰려면 corepack enable 필요.
COPY frontend/package*.json ./
RUN npm ci

# ---------- builder ----------
FROM node:20-bullseye-slim AS builder
WORKDIR /app
ENV NODE_ENV=production
# 빌드 타임 공개변수(코드에서 process.env.NEXT_PUBLIC_* 읽음)
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

COPY --from=deps /app/node_modules ./node_modules
# 프론트 소스 복사
COPY frontend ./
# Next.js 15 빌드
RUN npm run build

# ---------- runner ----------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# 런타임에 필요한 산출물/파일만 복사
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./
COPY --from=deps    /app/node_modules ./node_modules

EXPOSE 8080
# Cloud Run 표준 포트로 기동
CMD ["npm", "run", "start", "--", "-p", "8080"]