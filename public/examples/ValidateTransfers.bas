Attribute VB_Name = "ValidateTransfers"
Option Explicit

Private Const COORD_TOLERANCE As Double = 0.0000001

Private Function NormalizeStationName(ByVal value As Variant) As String
    NormalizeStationName = LCase$(Trim$(CStr(value)))
End Function

Private Function CoordinateKey(ByVal latitude As Double, ByVal longitude As Double) As String
    CoordinateKey = Format$(latitude, "0.0000000") & "|" & Format$(longitude, "0.0000000")
End Function

Private Function GetStationWorksheet() As Worksheet
    On Error Resume Next
    Set GetStationWorksheet = ThisWorkbook.Worksheets("車站")
    If GetStationWorksheet Is Nothing Then
        Set GetStationWorksheet = ThisWorkbook.Worksheets("Stations")
    End If
    On Error GoTo 0
End Function

Private Function NextTransferId(ByVal usedIds As Object) As String
    Dim index As Long
    Dim candidate As String

    index = 1
    Do
        candidate = "XFER_" & Format$(index, "000")
        If Not usedIds.Exists(candidate) Then
            usedIds(candidate) = True
            NextTransferId = candidate
            Exit Function
        End If
        index = index + 1
    Loop
End Function

Public Sub CompleteTransfersAndValidate()
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim rowIndex As Long
    Dim stationName As String
    Dim stationId As String
    Dim latitude As Double
    Dim longitude As Double
    Dim coordKey As String
    Dim existingTransfer As String

    Dim nameFirstCoord As Object
    Dim nameMismatch As Object
    Dim coordCounts As Object
    Dim coordTransfer As Object
    Dim usedTransferIds As Object

    Dim mismatchCount As Long
    Dim transferRowCount As Long

    Set ws = GetStationWorksheet()

    If ws Is Nothing Then
        MsgBox "找不到「車站」或「Stations」工作表。", vbCritical
        Exit Sub
    End If

    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row

    If lastRow < 2 Then
        MsgBox "車站工作表沒有資料。", vbExclamation
        Exit Sub
    End If

    Set nameFirstCoord = CreateObject("Scripting.Dictionary")
    Set nameMismatch = CreateObject("Scripting.Dictionary")
    Set coordCounts = CreateObject("Scripting.Dictionary")
    Set coordTransfer = CreateObject("Scripting.Dictionary")
    Set usedTransferIds = CreateObject("Scripting.Dictionary")

    ws.Cells(1, "E").Value = "轉乘群組"
    ws.Cells(1, "F").Value = "轉乘驗證"
    ws.Range("A2:F" & lastRow).Interior.Pattern = xlNone

    ' 第一階段：
    ' 1. 驗證同名站的經緯度是否一致。
    ' 2. 統計完全相同座標出現幾次。
    ' 3. 保留既有 XFER ID，避免站名修改或資料重排後改變 topology。
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationId <> "" And stationName <> "" Then
            If Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
                nameMismatch(stationName) = True
            Else
                latitude = CDbl(ws.Cells(rowIndex, "C").Value)
                longitude = CDbl(ws.Cells(rowIndex, "D").Value)
                coordKey = CoordinateKey(latitude, longitude)

                If coordCounts.Exists(coordKey) Then
                    coordCounts(coordKey) = CLng(coordCounts(coordKey)) + 1
                Else
                    coordCounts(coordKey) = 1
                End If

                If nameFirstCoord.Exists(stationName) Then
                    If CStr(nameFirstCoord(stationName)) <> coordKey Then
                        nameMismatch(stationName) = True
                    End If
                Else
                    nameFirstCoord(stationName) = coordKey
                End If

                existingTransfer = Trim$(CStr(ws.Cells(rowIndex, "E").Value))
                If UCase$(Left$(existingTransfer, 5)) = "XFER_" Then
                    usedTransferIds(existingTransfer) = True
                    If Not coordTransfer.Exists(coordKey) Then
                        coordTransfer(coordKey) = existingTransfer
                    End If
                End If
            End If
        End If
    Next rowIndex

    ' 第二階段：對每個重複座標群組建立/保留穩定的 XFER ID。
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))

        If stationId <> "" And _
           IsNumeric(ws.Cells(rowIndex, "C").Value) And _
           IsNumeric(ws.Cells(rowIndex, "D").Value) Then

            latitude = CDbl(ws.Cells(rowIndex, "C").Value)
            longitude = CDbl(ws.Cells(rowIndex, "D").Value)
            coordKey = CoordinateKey(latitude, longitude)

            If coordCounts.Exists(coordKey) And CLng(coordCounts(coordKey)) > 1 Then
                If Not coordTransfer.Exists(coordKey) Then
                    coordTransfer(coordKey) = NextTransferId(usedTransferIds)
                End If
            End If
        End If
    Next rowIndex

    ' 第三階段：寫回轉乘群組與驗證結果。
    For rowIndex = 2 To lastRow
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If Trim$(CStr(ws.Cells(rowIndex, "A").Value)) = "" Then
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").ClearContents

        ElseIf Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").Value = "錯誤 - 經緯度不是數字"
            ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(254, 202, 202)

        Else
            latitude = CDbl(ws.Cells(rowIndex, "C").Value)
            longitude = CDbl(ws.Cells(rowIndex, "D").Value)
            coordKey = CoordinateKey(latitude, longitude)

            If coordTransfer.Exists(coordKey) Then
                ws.Cells(rowIndex, "E").Value = CStr(coordTransfer(coordKey))
                transferRowCount = transferRowCount + 1
            Else
                ws.Cells(rowIndex, "E").ClearContents
            End If

            If stationName <> "" And nameMismatch.Exists(stationName) Then
                ws.Cells(rowIndex, "F").Value = "錯誤 - 同名站座標不一致"
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(254, 202, 202)
            ElseIf coordTransfer.Exists(coordKey) Then
                ws.Cells(rowIndex, "F").Value = "正常 - " & CStr(coordTransfer(coordKey))
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(220, 252, 231)
            Else
                ws.Cells(rowIndex, "F").ClearContents
            End If
        End If
    Next rowIndex

    mismatchCount = nameMismatch.Count

    If mismatchCount = 0 Then
        MsgBox "轉乘群組已完成，經緯度驗證通過。" & vbCrLf & _
               "轉乘資料列：" & transferRowCount & vbCrLf & _
               "轉乘群組使用穩定的 XFER_### ID。", vbInformation
    Else
        MsgBox "轉乘群組已完成，但驗證失敗。" & vbCrLf & _
               mismatchCount & " 個同名站的經緯度不一致。" & vbCrLf & _
               "請修正紅色資料列。", vbCritical
    End If
End Sub

Public Sub ValidateTransferCoordinates()
    CompleteTransfersAndValidate
End Sub
