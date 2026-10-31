import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

// Se crea un pool de conexiones usando la URL de Neon en tu archivo .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Requerido por Neon para conexiones seguras
  }
});

pool.connect()
  .then(() => console.log('✅ Conectado a la base de datos PostgreSQL (Neon)'))
  .catch(err => console.error('❌ Error de conexión a la base de datos', err));

export default {
  query: (text, params) => pool.query(text, params),
  pool // Exportamos el pool para usarlo en las transacciones
};