# DANE test certificates (#345)

Test-only keys and certificates for the DANE tests (`test/unit/dane-verify.test.ts`, `test/unit/mx-transport-dane.test.ts`), EC P-256, valid for 100 years (except `ta-expired`, and the `ta3-*` start dates below). Never trusted anywhere but in those tests.

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
| `ta3-root.cert.pem` | Three-level chain (#455): root "BunMail DANE test root", valid from 2020-01-01 |
| `ta3-int.cert.pem` | Intermediate "BunMail DANE test intermediate" (CA, `pathlen:0`) issued by the root, valid from 2024-01-01 |
| `ta3-leaf.cert.pem` | Leaf `mx.dane.example` issued by the intermediate, valid from 2020-01-01 (before its issuer, so a clock in 2022 tells the anchor's dates from those below it) |
| `ta3-chain.cert.pem`, `ta3-chain.key.pem` | Leaf, intermediate, root (in order), and the leaf's key |
| `ta3-unordered.cert.pem`, `ta3-unordered.key.pem` | Leaf, root, intermediate (out of order, as TLS 1.3 allows), and the same key |
| `ta3-int-forged.cert.pem` | The intermediate's subject and key, issued by another root with the root's name: a broken link to the real root |
| `ta3-sub.cert.pem` | Sub-CA "BunMail DANE test sub-CA" issued by the intermediate, beyond its `pathlen:0` |
| `ta3-deep-leaf.cert.pem` | Leaf `mx.dane.example` issued by the sub-CA |
| `bad-notca.chain.pem`, `bad-nobc.chain.pem`, `bad-nokcs.chain.pem`, `bad-negpl.chain.pem` | #455 review: each a bundle of leaf `mx.dane.example`, an intermediate that must not issue (`CA:FALSE`; no basicConstraints; `CA:TRUE` with keyUsage `digitalSignature` only; a negative pathLenConstraint), and the root "BunMail DANE bad-issuer root"; no keys kept |
| `ta-loop.chain.pem` | #455 review: ten self-signed CA certificates "BunMail DANE loop" sharing one P-521 key, so each issues every other (the cost-bound test); key not kept |

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

The `ta3-*` chain (#455), with bash (OpenSSL 3.6; `K` as above):

```bash
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > ca.ext
printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > ca0.ext
printf 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:mx.dane.example\n' > leaf.ext
openssl req -x509 $K -keyout root.key.pem -out ta3-root.cert.pem -not_before 20200101000000Z -not_after 21200101000000Z -subj "/CN=BunMail DANE test root" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req $K -keyout int.key.pem -out int.csr -subj "/CN=BunMail DANE test intermediate"
openssl x509 -req -in int.csr -CA ta3-root.cert.pem -CAkey root.key.pem -set_serial 0x$(openssl rand -hex 8) -extfile ca0.ext -not_before 20240101000000Z -not_after 21200101000000Z -out ta3-int.cert.pem
openssl req $K -keyout ta3-chain.key.pem -out leaf.csr -subj "/CN=mx.dane.example"
openssl x509 -req -in leaf.csr -CA ta3-int.cert.pem -CAkey int.key.pem -set_serial 0x$(openssl rand -hex 8) -extfile leaf.ext -not_before 20200101000000Z -not_after 21200101000000Z -out ta3-leaf.cert.pem
cat ta3-leaf.cert.pem ta3-int.cert.pem ta3-root.cert.pem > ta3-chain.cert.pem
cat ta3-leaf.cert.pem ta3-root.cert.pem ta3-int.cert.pem > ta3-unordered.cert.pem && cp ta3-chain.key.pem ta3-unordered.key.pem
# ta3-int-forged: a second self-signed root with the same subject signs int.csr (ca0.ext), then that root is discarded.
# ta3-sub: a CSR for "/CN=BunMail DANE test sub-CA" signed by the intermediate with ca.ext;
# ta3-deep-leaf: a CSR for "/CN=mx.dane.example" signed by the sub-CA with leaf.ext (both -not_before 20240101000000Z).
openssl verify -CAfile ta3-root.cert.pem -untrusted ta3-int.cert.pem ta3-leaf.cert.pem   # OK
openssl verify -CAfile ta3-root.cert.pem -untrusted <(cat ta3-int.cert.pem ta3-sub.cert.pem) ta3-deep-leaf.cert.pem   # path length constraint exceeded
rm *.csr *.ext root.key.pem int.key.pem   # and every other key but the served leaf's
```

The `bad-*` bundles and `ta-loop` (#455 review), with bash (OpenSSL 3.6; `K` as above):

```bash
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,keyCertSign\n' > notca.ext
printf 'keyUsage=critical,keyCertSign\n' > nobc.ext
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature\n' > nokcs.ext
printf 'basicConstraints=critical,DER:30:06:01:01:FF:02:01:FF\nkeyUsage=critical,keyCertSign\n' > negpl.ext
printf 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:mx.dane.example\n' > leaf.ext
openssl req -x509 $K -keyout root.key -out root.pem -days 36500 -subj "/CN=BunMail DANE bad-issuer root" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
for e in notca nobc nokcs negpl; do
  openssl req $K -keyout int.key -out int.csr -subj "/CN=BunMail DANE bad-issuer $e"
  openssl x509 -req -in int.csr -CA root.pem -CAkey root.key -set_serial 0x$(openssl rand -hex 8) -extfile $e.ext -days 36500 -out int.pem
  openssl req $K -keyout leaf.key -out leaf.csr -subj "/CN=mx.dane.example"
  openssl x509 -req -in leaf.csr -CA int.pem -CAkey int.key -set_serial 0x$(openssl rand -hex 8) -extfile leaf.ext -days 36500 -out leaf.pem
  cat leaf.pem int.pem root.pem > bad-$e.chain.pem
done
openssl ecparam -name secp521r1 -genkey -noout -out loop.key
for i in $(seq 1 10); do openssl req -x509 -key loop.key -days 36500 -subj "/CN=BunMail DANE loop" -set_serial $i -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,digitalSignature" -addext "subjectAltName=DNS:mx.dane.example" >> ta-loop.chain.pem; done
rm -f *.key *.csr *.ext root.pem int.pem leaf.pem
```
