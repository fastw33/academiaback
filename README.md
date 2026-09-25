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
`PUBLIC_API_URL` debe ser la URL publica del backend, por ejemplo
`https://backacademy.fastwaysas.com`. Los videos se cargan directamente a esa
URL con tokens temporales para evitar que Next.js almacene archivos grandes en
memoria o intermedie la reproducción. Incluye la URL del frontend en
`CORS_ORIGINS`.
