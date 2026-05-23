"""
PaddleOCR Microservice — BRECHA 11
FastAPI server que expone PaddleOCR vía HTTP.

Instalación:
    pip install fastapi uvicorn paddleocr paddlepaddle pillow

Uso:
    python services/ocr/paddle_server.py
    # Corre en puerto 8001 por defecto

PADDLE_OCR_URL=http://localhost:8001 en .env del proyecto Node.js
"""

import os
import base64
import io
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# PaddleOCR puede ser lento al iniciar — se carga lazy
_paddle_ocr = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("paddle_server")

app = FastAPI(title="ARIA PaddleOCR Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


def get_paddle():
    global _paddle_ocr
    if _paddle_ocr is None:
        from paddleocr import PaddleOCR
        logger.info("Inicializando PaddleOCR (primera vez, puede tardar)...")
        _paddle_ocr = PaddleOCR(
            use_angle_cls=True,
            lang="latin",  # Español/Latin
            show_log=False,
            use_gpu=False,  # Cambiar a True si tienes GPU
        )
        logger.info("PaddleOCR listo.")
    return _paddle_ocr


class OCRRequest(BaseModel):
    image: str          # base64 encoded image
    lang: Optional[str] = "latin"
    output_format: Optional[str] = "text"


class OCRBlock(BaseModel):
    text: str
    confidence: float
    box: list


class OCRResponse(BaseModel):
    result: list[OCRBlock]
    engine: str = "paddle"
    total_blocks: int


@app.get("/health")
def health():
    return {"status": "ok", "engine": "paddle"}


@app.post("/ocr", response_model=OCRResponse)
def ocr_endpoint(req: OCRRequest):
    try:
        # Decodificar imagen base64
        image_bytes = base64.b64decode(req.image)
        from PIL import Image
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        ocr = get_paddle()

        # Correr OCR
        import numpy as np
        img_array = np.array(image)
        results = ocr.ocr(img_array, cls=True)

        if not results or not results[0]:
            return OCRResponse(result=[], total_blocks=0)

        blocks = []
        for line in results[0]:
            if not line:
                continue
            box, (text, confidence) = line
            blocks.append(OCRBlock(
                text=text,
                confidence=float(confidence),
                box=box,
            ))

        return OCRResponse(result=blocks, total_blocks=len(blocks))

    except Exception as e:
        logger.error(f"Error en OCR: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    port = int(os.environ.get("PADDLE_PORT", "8001"))
    logger.info(f"Iniciando PaddleOCR server en puerto {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
