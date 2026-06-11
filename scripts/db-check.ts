// Quick read-only probe: which shops are installed / Square-connected.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
  if (match && !(match[1] in process.env)) process.env[match[1]] = match[3];
}

const { default: prisma } = await import("../app/db.server");

const sessions = await prisma.session.findMany({
  select: { shop: true, isOnline: true, scope: true },
});
const connections = await prisma.squareConnection.findMany({
  select: { shop: true, scopes: true, merchantName: true },
});
console.log("SESSIONS:", JSON.stringify(sessions, null, 1));
console.log("SQUARE:", JSON.stringify(connections, null, 1));
await prisma.$disconnect();
