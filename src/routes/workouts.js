import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';

const router = Router();

// Helper para generar IDs únicos
const generateId = () => `w_${uuidv4()}`;

// 1. POST /api/workouts - Crear un nuevo entrenamiento
router.post('/', async (req, res, next) => {
  const {
    clientId, type, startedAt, durationMin, perceivedEffort, notes, exercises = [],
  } = req.body;

  if (!type || !startedAt || !durationMin) {
    return res.status(422).json({ error: 'Faltan campos obligatorios: type, startedAt, durationMin' });
  }

  const workoutId = generateId();
  const now = new Date().toISOString();
  
  // En Postgres, las transacciones requieren obtener un cliente del pool dedicado
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN'); // Iniciar transacción

    // Insertar el workout (Postgres usa $1, $2 en vez de ?)
    await client.query(`
      INSERT INTO workouts (id, client_id, type, started_at, duration_min, perceived_effort, notes, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [workoutId, clientId, type, startedAt, durationMin, perceivedEffort, notes, now]);

    // Insertar los ejercicios
    for (let index = 0; index < exercises.length; index++) {
      const ex = exercises[index];
      await client.query(`
        INSERT INTO exercises (id, workout_id, name, sets, reps, weight_kg, "order")
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [`e_${uuidv4()}`, workoutId, ex.name, ex.sets, ex.reps, ex.weightKg, ex.order ?? index + 1]);
    }

    await client.query('COMMIT'); // Guardar cambios si todo salió bien

    // Obtener el recurso recién creado
    const workoutRes = await client.query('SELECT * FROM workouts WHERE id = $1', [workoutId]);
    const exercisesRes = await client.query('SELECT * FROM exercises WHERE workout_id = $1', [workoutId]);
    
    res.status(201).json({ ...workoutRes.rows[0], exercises: exercisesRes.rows });
    
  } catch (error) {
    await client.query('ROLLBACK'); // Deshacer cambios si hubo un error
    
    // Código 23505 en Postgres significa "Unique Violation" (Idempotencia)
    if (error.code === '23505') {
      const existing = await client.query('SELECT * FROM workouts WHERE client_id = $1', [clientId]);
      const existingExercises = await client.query('SELECT * FROM exercises WHERE workout_id = $1', [existing.rows[0].id]);
      return res.status(200).json({ ...existing.rows[0], exercises: existingExercises.rows });
    }
    next(error);
  } finally {
    client.release(); // Siempre liberar el cliente al final
  }
});

// 2. GET /api/workouts - Listar entrenamientos con filtros
router.get('/', async (req, res, next) => {
  const { type, from, to, limit = 20, include } = req.query;
  let query = 'SELECT * FROM workouts WHERE deleted = 0';
  const params = [];
  let paramIndex = 1; // Contador para los $1, $2, $3...

  if (type) {
    query += ` AND type = $${paramIndex++}`;
    params.push(type);
  }
  if (from) {
    query += ` AND started_at >= $${paramIndex++}`;
    params.push(from);
  }
  if (to) {
    query += ` AND started_at <= $${paramIndex++}`;
    params.push(to);
  }
  query += ` ORDER BY started_at DESC LIMIT $${paramIndex++}`;
  params.push(Number(limit));

  try {
    const result = await db.query(query, params);
    const workouts = result.rows;

    if (include === 'exercises') {
      for (const w of workouts) {
        const exResult = await db.query('SELECT * FROM exercises WHERE workout_id = $1', [w.id]);
        w.exercises = exResult.rows;
      }
    }

    res.json(workouts);
  } catch (error) {
    next(error);
  }
});

// 3. PATCH /api/workouts/:id - Actualizar parcialmente
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const allowedUpdates = ['durationMin', 'perceivedEffort', 'notes', 'type', 'startedAt'];
  const fields = [];
  const values = [];

  Object.keys(updates).forEach(key => {
    if (allowedUpdates.includes(key)) {
      // MAPEAMOS LOS NOMBRES AL FORMATO DE LA BASE DE DATOS
      let dbColumn = key;
      if (key === 'durationMin') dbColumn = 'duration_min';
      if (key === 'perceivedEffort') dbColumn = 'perceived_effort';
      if (key === 'startedAt') dbColumn = 'started_at';

      fields.push(`${dbColumn} = ?`);
      values.push(updates[key]);
    }
  });

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  }

  // Siempre actualizamos updated_at
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id); // Para el WHERE

  const query = `UPDATE workouts SET ${fields.join(', ')} WHERE id = ? AND deleted = 0`;
  
  try {
    const result = db.prepare(query).run(...values);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Entrenamiento no encontrado' });
    }
    const updated = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// 4. DELETE /api/workouts/:id - Borrado lógico
router.delete('/:id', async (req, res, next) => {
  const { id } = req.params;
  const now = new Date().toISOString();

  try {
    const result = await db.query(
      'UPDATE workouts SET deleted = 1, updated_at = $1 WHERE id = $2 AND deleted = 0', 
      [now, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Entrenamiento no encontrado' });
    }

    res.status(204).send(); 
  } catch (error) {
    next(error);
  }
});

// 5. POST /api/workouts/sync - Sincronización offline
router.post('/sync', async (req, res, next) => {
  const { lastSyncAt, changes = [] } = req.body;
  const serverTime = new Date().toISOString();

  const applied = [];
  const conflicts = [];

  try {
    const result = await db.query(
      'SELECT * FROM workouts WHERE updated_at > $1 ORDER BY updated_at ASC',
      [lastSyncAt || '1970-01-01T00:00:00Z']
    );

    res.json({
      serverTime,
      applied,
      conflicts,
      serverChanges: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

export default router;