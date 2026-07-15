import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { Prisma } from "../generated/prisma/client.js";

type PrismaRuntimeError = Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError;

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientInitializationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: PrismaRuntimeError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const code = String("code" in exception ? exception.code : exception.errorCode || "");
    if (["ECONNREFUSED", "P1000", "P1001", "P1002", "P1003", "P1017"].includes(code)) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: "Service Unavailable",
        message: "PostgreSQL sedang tidak tersedia. Pembayaran tidak diproses dan aman untuk dicoba lagi.",
      });
      return;
    }
    if (code === "P2002") {
      response.status(HttpStatus.CONFLICT).json({ statusCode: HttpStatus.CONFLICT, error: "Conflict", message: "Data dengan identifier yang sama sudah diproses." });
      return;
    }
    if (code === "P2025") {
      response.status(HttpStatus.NOT_FOUND).json({ statusCode: HttpStatus.NOT_FOUND, error: "Not Found", message: "Data yang diminta tidak ditemukan." });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Operasi database gagal. Tidak ada detail internal yang diekspos.",
    });
  }
}
