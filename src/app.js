import express from 'express';
import workoutRoutes from './routes/workouts.js';

const app = express();

// Middleware para parsear JSON en el body de las peticiones
app.use(express.json());

// Middleware de logging simple
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Monta las rutas de entrenamientos bajo el prefijo /api
app.use('/api/workouts', workoutRoutes);

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Algo salió mal en el servidor' });
});

export default app;