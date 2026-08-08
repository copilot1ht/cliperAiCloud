import { Body, Controller, Headers, Inject, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { clearSessionCookie, sessionCookie, sessionToken } from "../security/session-cookie.js";
import { AuthService } from "./auth.service.js";

@Controller("api/auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() input: { email?: string; password?: string; displayName?: string }, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.register(input);
    response.setHeader("Set-Cookie", sessionCookie(result.token, result.expiresAt));
    return result;
  }

  @Post("login")
  async login(@Body() input: { email?: string; password?: string }, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(input);
    response.setHeader("Set-Cookie", sessionCookie(result.token, result.expiresAt));
    return result;
  }

  @Post("session")
  async session(@Headers("authorization") authorization?: string, @Headers("cookie") cookie?: string) {
    return this.auth.session(sessionToken(authorization, cookie));
  }

  @Post("logout")
  async logout(@Res({ passthrough: true }) response: Response, @Headers("authorization") authorization?: string, @Headers("cookie") cookie?: string) {
    response.setHeader("Set-Cookie", clearSessionCookie());
    return this.auth.logout(sessionToken(authorization, cookie));
  }

  @Post("password-reset/request")
  async requestPasswordReset(@Body() input: { email?: string }) {
    return this.auth.requestPasswordReset(input);
  }

  @Post("password-reset/confirm")
  async confirmPasswordReset(@Body() input: { token?: string; password?: string }) {
    return this.auth.confirmPasswordReset(input);
  }
}
