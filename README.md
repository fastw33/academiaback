# Academia Fastway API

Backend independiente de Academia Fastway, construido con Node.js y Express.

## Servicios

- MongoDB mediante Mongoose.
- Autenticacion JWT en cookie `httpOnly`.
- Cursos con lecciones ordenadas y progreso secuencial.
- Acceso configurable por alumno.
- Videos privados en almacenamiento compatible con S3.

## Desarrollo local

```bash
npm install
copy .env.example .env
npm run dev
```

El servidor queda disponible en `http://localhost:4100` y expone su estado en
`GET /api/health`.

## Produccion

Configura las variables descritas en `.env.example` en el proveedor de
despliegue y ejecuta:

```bash
npm ci
npm start
```

`S3_ENDPOINT` puede apuntar a MinIO u otro proveedor compatible con S3.
