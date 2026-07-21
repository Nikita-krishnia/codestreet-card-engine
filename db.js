require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Supabase cloud connection
  },
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};