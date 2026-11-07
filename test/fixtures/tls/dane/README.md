# DANE test certificates (#345)

Test-only keys and certificates for the DANE tests (`test/unit/dane-verify.test.ts`, `test/unit/mx-transport-dane.test.ts`), EC P-256, valid for 100 years (except `ta-expired`). Never trusted anywhere but in those tests.

| File | What it is |
|---|---|
| `ee.cert.pem`, `ee.key.pem` | Self-signed leaf `mx.dane.example` (DANE-EE) |
| `ca.cert.pem` | "BunMail DANE test CA", the DANE-TA trust anchor (its key not kept) |
| `ta-leaf.cert.pem` | Leaf `mx.dane.example` signed by the CA |
| `ta-chain.cert.pem`, `ta-chain.key.pem` | `ta-leaf.cert.pem` followed by `ca.cert.pem`, and the leaf's key: what the fixture server presents |
| `ta-wildcard.cert.pem` | Leaf with the DNS-ID `*.dane.example` (CN `wildcard`), signed by the CA |
| `ta-cn-only.cert.pem` | Leaf with CN `mx.dane.example` and no subjectAltName, signed by the CA |
| `ta-expired.cert.pem` | Leaf `mx.dane.example` signed by the CA, valid 2000-01-01 to 2001-01-01 |
| `ta-forged.cert.pem` | Leaf `mx.dane.example` whose issuer name is the CA's but signed by another key |
| `ec-compressed.cert.pem` | Self-signed leaf whose P-256 key is encoded as a compressed point (SPKI of 59 bytes) |
| `rsa-pss.cert.pem` | Self-signed RSA-PSS leaf (Bun cannot parse its key, so matching must use the DER bytes) |

Made once with OpenSSL 3.6 (`K="-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes"`):

```bash
openssl req -x509 $K -keyout ee.key.pem -out ee.cert.pem -days 36500 -subj "/CN=mx.dane.example" -addext "subjectAltName=DNS:mx.dane.example"
openssl req -x509 $K -keyout ca.key.pem -out ca.cert.pem -days 36500 -subj "/CN=BunMail DANE test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
# Each leaf: a CSR, then signed by the CA with basicConstraints=CA:FALSE and its subjectAltName, e.g.
openssl req $K -keyout ta-leaf.key.pem -out ta-leaf.csr -subj "/CN=mx.dane.example"
printf 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:mx.dane.example\n' > ta-leaf.ext
openssl x509 -req -in ta-leaf.csr -CA ca.cert.pem -CAkey ca.key.pem -set_serial 0x$(openssl rand -hex 8) -extfile ta-leaf.ext -days 36500 -out ta-leaf.cert.pem
# ta-wildcard: subjectAltName=DNS:*.dane.example, CN wildcard; ta-cn-only: no subjectAltName;
# ta-expired: -not_before 20000101000000Z -not_after 20010101000000Z instead of -days;
# ta-forged: signed by a second self-signed CA with the same subject, then that CA discarded.
cat ta-leaf.cert.pem ca.cert.pem > ta-chain.cert.pem && mv ta-leaf.key.pem ta-chain.key.pem
rm ca.key.pem *.csr *.ext   # and the keys of the leaves only parsed, never served
```

The last two (#345 review), and the SPKI digests their tests expect, which come from OpenSSL and not from BunMail's DER walker:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out raw.pem
openssl ec -in raw.pem -conv_form compressed -param_enc named_curve -out ec.key.pem
openssl req -x509 -key ec.key.pem -out ec-compressed.cert.pem -days 36500 -subj "/CN=mx.dane.example" -addext "subjectAltName=DNS:mx.dane.example"
openssl req -x509 -newkey rsa-pss -pkeyopt rsa_keygen_bits:2048 -nodes -keyout pss.key.pem -out rsa-pss.cert.pem -days 36500 -subj "/CN=mx.dane.example" -addext "subjectAltName=DNS:mx.dane.example"
# The SPKI is the 7th depth-2 element of `openssl asn1parse -inform DER`; hash bytes [offset, offset + hl + l) of the DER.
rm raw.pem ec.key.pem pss.key.pem
```
