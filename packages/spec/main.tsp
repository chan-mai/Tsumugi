import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";
import "./operations.tsp";

using Http;

// REST APIのOpenAPI定義の源泉(ADR-0038)
// 文面は英語で書く, 読み手が日本語話者に限らない
// 構成によって501になる経路も載せる, 定義を構成ごとに変えると生成物が環境ごとに変わる
// info.versionはビルド後の値を使わず, 配信時にpackages/tsumugiのAPI_VERSIONで上書きされる
@service(#{ title: "Tsumugi REST API" })
@useAuth(bearerAuth | cookieAuth)
@doc("Management API of Tsumugi, a job management system built on the Cloudflare stack. Endpoints that depend on optional configuration answer 501 when that configuration is absent.")
namespace Tsumugi;

// 認証は差し替え可能なので, 同梱のbearerAuthが受け付ける2つを並べる
// モデル名がそのままsecuritySchemesのキーになる
@doc("Authorization header.")
model bearerAuth is Http.BearerAuth;

@doc("Same token in a cookie. The cookie name is configured per deployment.")
model cookieAuth is Http.ApiKeyAuth<ApiKeyLocation.cookie, "tsumugi_token">;
