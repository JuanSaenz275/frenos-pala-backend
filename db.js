const { Pool } = require('pg');

const pool = new Pool({
    // Fíjate que ahora dice pooler.supabase.com y termina en 6543
    connectionString: 'postgresql://postgres.jvzbrzhufclkaprrfyfm:FrenosPala2026*@aws-0-ca-central-1.pooler.supabase.com:6543/postgres',
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect()
    .then(() => console.log('✅ Conectado a la Base de Datos en Supabase exitosamente'))
    .catch(err => console.error('❌ Error conectando a Supabase:', err.stack));

module.exports = pool;