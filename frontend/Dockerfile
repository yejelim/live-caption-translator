# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:20-bullseye-slim AS deps
WORKDIR /app

# 1) package.json / package-lock.json 을 먼저 "명시적으로" 복사
COPY package.json ./
COPY package-lock.json ./

# 2) 디버그: 파일이 진짜 있는지 출력(문제 해결 후 주석 처리/삭제 가능)
RUN ls -la

# 3) lockfile 없으면 즉시 실패(원인 명확화)
RUN test -f package-lock.json || (echo '❌ Missing package-lock.json in build context' && exit 1)

# 4) 의존성 설치
RUN npm ci

# ---------- builder ----------
FROM node:20-bullseye-slim AS builder
WORKDIR /app
ENV NODE_ENV=production

# 빌드 타임 공개 환경변수(필요 시)
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

COPY --from=deps /app/node_modules ./node_modules
# 전체 프론트 소스 복사
COPY . .
RUN npm run build

# ---------- runner ----------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# 런타임 필요한 것만
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

EXPOSE 8080
CMD ["npm", "run", "start", "--", "-p", "8080"]