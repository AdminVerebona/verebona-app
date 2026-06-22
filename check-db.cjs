const postgres = require("postgres");

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error("DATABASE_URL absente");
    process.exit(1);
  }

  const sql = postgres(url, { ssl: "require" });

  try {
    const rows = await sql.unsafe("select id from accounts limit 1");
    console.log("OK DB accounts:", rows);
  } catch (error) {
    console.error("DB ERROR:", error.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
