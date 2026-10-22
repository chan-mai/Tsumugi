import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";
import "./operations.tsp";

using Http;

// REST APIのOpenAPI定義の生成元(ADR-0038)
// @docは英語で書くこと！
// 構成次第で501の経路も記載(生成物の環境非依存)
// info.versionは配信時にAPI_VERSIONで上書き
@service(#{ title: "Tsumugi REST API" })
@useAuth(bearerAuth | cookieAuth)
@doc("Management API of Tsumugi, a job management system built on the Cloudflare stack. Endpoints that depend on optional configuration answer 501 when that configuration is absent.")
namespace Tsumugi;

// 同梱bearerAuthの受付形式2種(認証は差し替え可能)
// モデル名はsecuritySchemesのキー
@doc("Authorization header.")
model bearerAuth is Http.BearerAuth;

@doc("Same token in a cookie. The cookie name is configured per deployment.")
model cookieAuth is Http.ApiKeyAuth<ApiKeyLocation.cookie, "tsumugi_token">;
