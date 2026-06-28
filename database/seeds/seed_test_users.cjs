const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function main() {
  try {
    console.log('🌱 Iniciando siembra de roles y usuarios de prueba...');

    // 1. Crear roles si no existen
    const rolesToCheck = ['estudiante', 'docente', 'administrador'];
    for (const rolNombre of rolesToCheck) {
      const checkRol = await pool.query('SELECT id FROM academico.roles WHERE nombre = $1', [rolNombre]);
      if (checkRol.rows.length === 0) {
        await pool.query('INSERT INTO academico.roles (nombre, descripcion) VALUES ($1, $2)', [rolNombre, `Rol de ${rolNombre}`]);
        console.log(`✅ Rol creado: ${rolNombre}`);
      } else {
        console.log(`📌 Rol ya existe: ${rolNombre}`);
      }
    }

    // Obtener ids de roles
    const rolesRes = await pool.query('SELECT id, nombre FROM academico.roles');
    const roleMap = {};
    rolesRes.rows.forEach(row => {
      roleMap[row.nombre] = row.id;
    });

    // 2. Crear usuario estudiante de prueba
    const emailEst = 'estudiante@utn.edu.ec';
    const checkUserEst = await pool.query('SELECT id FROM academico.usuarios WHERE email = $1', [emailEst]);
    if (checkUserEst.rows.length === 0) {
      await pool.query(`
        INSERT INTO academico.usuarios (rol_id, nombres, apellidos, email, password_hash, identificacion, estado)
        VALUES ($1, 'Estudiante', 'Prueba', $2, 'password123', '1000000001', 'activo')
      `, [roleMap['estudiante'], emailEst]);
      console.log(`✅ Usuario estudiante creado: ${emailEst}`);
    } else {
      console.log(`📌 Usuario estudiante ya existe: ${emailEst}`);
    }

    // 3. Crear usuario docente de prueba
    const emailDoc = 'docente@utn.edu.ec';
    const checkUserDoc = await pool.query('SELECT id FROM academico.usuarios WHERE email = $1', [emailDoc]);
    if (checkUserDoc.rows.length === 0) {
      await pool.query(`
        INSERT INTO academico.usuarios (rol_id, nombres, apellidos, email, password_hash, identificacion, estado)
        VALUES ($1, 'Docente', 'Prueba', $2, 'password123', '1000000002', 'activo')
      `, [roleMap['docente'], emailDoc]);
      console.log(`✅ Usuario docente creado: ${emailDoc}`);
    } else {
      console.log(`📌 Usuario docente ya existe: ${emailDoc}`);
    }

    console.log('🎉 Siembra completada con éxito.');
  } catch (err) {
    console.error('❌ Error sembrando base de datos:', err);
  } finally {
    await pool.end();
  }
}

main();
