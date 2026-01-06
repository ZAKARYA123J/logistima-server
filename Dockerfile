# Use Node 20
FROM node:20-alpine

WORKDIR /src

COPY package*.json ./
RUN npm install -g pnpm
RUN pnpm install

COPY . .

# If you use TypeScript
RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "run", "dev"]
